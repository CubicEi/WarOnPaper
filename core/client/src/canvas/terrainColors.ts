import type { TerrainMap } from "@wop/shared";

/** Ground / resource fill colors (dark tactical board). */
export const TERRAIN_COLORS = {
  ocean: "#1e3340",
  land: "#3d4a3a",
  mountain: "#5c5852",
  forest: "#2f6b3c",
  oil: "#c4a547",
  uranium: "#7ea84d",
} as const;

export function terrainFillColor(map: TerrainMap, x: number, y: number): string {
  const cell = map.cells[y * map.width + x];
  if (!cell) return TERRAIN_COLORS.ocean;
  // Forest fills the cell; oil/uranium show as borders only
  if (cell.resource?.kind === "forest") return TERRAIN_COLORS.forest;
  return TERRAIN_COLORS[cell.ground];
}

/** Draw filled terrain cells into an already-transformed layout-space context.
 *  `zoom` matches the map scale so oil/uranium borders thin when zooming in. */
export function fillTerrainCells(
  ctx: CanvasRenderingContext2D,
  terrain: TerrainMap,
  originX: number,
  originY: number,
  cell: number,
  zoom = 1,
): void {
  // Fill ground + forest
  for (let y = 0; y < terrain.height; y++) {
    for (let x = 0; x < terrain.width; x++) {
      ctx.fillStyle = terrainFillColor(terrain, x, y);
      ctx.fillRect(originX + x * cell, originY + y * cell, cell + 0.5, cell + 0.5);
    }
  }

  // Borders in layout space under scale(zoom): screenPx = lineWidth * zoom.
  // Thin with zoom the same way as grid lines.
  const borderScreenPx = Math.max(3, (cell * 0.2) / zoom);
  ctx.lineWidth = borderScreenPx / zoom;
  for (let y = 0; y < terrain.height; y++) {
    for (let x = 0; x < terrain.width; x++) {
      const c = terrain.cells[y * terrain.width + x];
      if (!c?.resource) continue;
      if (c.resource.kind === "oil") {
        ctx.strokeStyle = TERRAIN_COLORS.oil;
        ctx.strokeRect(originX + x * cell, originY + y * cell, cell, cell);
      } else if (c.resource.kind === "uranium") {
        ctx.strokeStyle = TERRAIN_COLORS.uranium;
        ctx.strokeRect(originX + x * cell, originY + y * cell, cell, cell);
      }
    }
  }
}
