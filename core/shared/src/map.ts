/** Grid cells → line counts are cells+1 (90×60 / 120×80 / 180×120 lines). */
export type MapSizeId = "89x59" | "119x79" | "179x119";

export interface MapConfig {
  id: MapSizeId;
  /** Horizontal cells (经向格数). */
  cellsX: number;
  /** Vertical cells (纬向格数). */
  cellsY: number;
  /** Vertical lines (经线). */
  linesX: number;
  /** Horizontal lines (纬线). */
  linesY: number;
}

export const MAP_SIZES: Record<MapSizeId, MapConfig> = {
  "89x59": { id: "89x59", cellsX: 89, cellsY: 59, linesX: 90, linesY: 60 },
  "119x79": { id: "119x79", cellsX: 119, cellsY: 79, linesX: 120, linesY: 80 },
  "179x119": { id: "179x119", cellsX: 179, cellsY: 119, linesX: 180, linesY: 120 },
};

/** Debug UI / init presets, ordered small → medium → large. */
export const MAP_SIZE_OPTIONS: ReadonlyArray<{
  id: MapSizeId;
  label: string;
}> = [
  { id: "89x59", label: "小 89×59" },
  { id: "119x79", label: "中 119×79" },
  { id: "179x119", label: "大 179×119" },
];

export const DEFAULT_MAP_SIZE_ID: MapSizeId = "89x59";

export function isMapSizeId(value: unknown): value is MapSizeId {
  return typeof value === "string" && value in MAP_SIZES;
}
